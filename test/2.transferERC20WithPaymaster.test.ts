import { ethers } from 'hardhat'
import {
	EntryPoint,
	EntryPoint__factory,
	AccountFactory,
	Account,
	Account__factory,
	TestToken__factory,
	TestToken,
	ZkProverZkpVerifierWrapper,
	ZkProverZkpVerifierWrapper__factory,
    VerifyingPaymaster,
    VerifyingPaymaster__factory,
} from '../typechain-types'
import {
	AddressZero,
	createAccount,
	createAccountOwner,
	createAddress,
	fund,
	generateBatchofERC20TransferOp,
	tostr
} from './testutils'
import { BigNumber, Wallet } from 'ethers'
import { expect } from 'chai'
import { UserOperationStruct } from '../typechain-types/contracts/Account'
import { compile_yul, halo2zkpVerifierAbi } from '../scripts/utils'
import ProofData from "./zkp_output/proof.json";
import { parseEther } from 'ethers/lib/utils'

const testLoopLimit = 128
const notFund = true

describe('2.transferERC20WithPaymaster.test', () => {
	let entryPoint: EntryPoint
	// let entryPointzkp: EntryPoint
	let verifier: ZkProverZkpVerifierWrapper
    let paymaster: VerifyingPaymaster
	const ethersSigners = ethers.provider.getSigner()
    const ethersSignerAdmin = ethers.provider.getSigner(1)
	let accountOwner: Wallet
	let refundAccount: Wallet
	let account: Account
	let token: TestToken
	let beneficiaryAddress: string
	let AccountFactory: AccountFactory
	let gasFirst: number
	let gasSecond: number
	const accountOwners: Wallet[] = []
	const accountFactorys: AccountFactory[] = []


	before(async () => {
		accountOwner = createAccountOwner()
		beneficiaryAddress = createAddress()
		refundAccount = createAccountOwner()

		// entryPointzkp = await new EntryPoint__factory(ethersSigners).deploy(
		// 	AddressZero
		// )
		let verifyCode = await compile_yul("contracts/zkp/zkpVerifier.yul");

		const factory = new ethers.ContractFactory(
			halo2zkpVerifierAbi,
			verifyCode,
			ethersSigners
		  );
		  const verifyContract = await factory.deploy();
		verifier = await new ZkProverZkpVerifierWrapper__factory(
			ethersSigners
		  ).deploy(verifyContract.address);
		entryPoint = await new EntryPoint__factory(ethersSigners).deploy(verifier.address)

		account = await new Account__factory(ethersSigners).deploy(
			entryPoint.address
		)
        token = await new TestToken__factory(ethersSigners).deploy()
        paymaster = await new VerifyingPaymaster__factory(ethersSigners).deploy(
            entryPoint.address,
            await ethersSigners.getAddress())

		// await fund(paymaster.address)
		await paymaster.deposit({value: ethers.utils.parseEther("1")})
    })

	it('account deposit should equal entryPoint balance', async () => {
		let accountNew : Account
		let accountOwnerNew : Wallet
		accountOwnerNew = createAccountOwner()
		;({ proxy: accountNew } =
			await createAccount(
				ethersSigners,
				await ethersSigners.getAddress(),
				entryPoint.address
		))
		await fund(account)		
		await accountNew.addDeposit({value: ethers.utils.parseEther("1")})
		expect(ethers.utils.formatEther(await accountNew.getDeposit())).to.equal('1.0')
	})

	it('account withdraw should fail if not owner', async () => {
		let accountNew : Account
		let accountOwnerNew : Wallet
		const beneficiaryAddressNew = createAddress()
		accountOwnerNew = createAccountOwner()
		;({ proxy: accountNew } =
			await createAccount(
				ethersSigners,
				await accountOwnerNew.getAddress(),
				entryPoint.address
		))
		await fund(account)		
		await accountNew.addDeposit({value: ethers.utils.parseEther("1")})		
		await expect(accountNew.withdrawDepositTo(beneficiaryAddressNew, ethers.utils.parseEther("0.1")))
			.to.revertedWith('only owner')

	})

	it('account withdraw should pass by owner withdraw', async () => {
		let accountNew : Account
		let accountOwnerNew : Wallet
		const beneficiaryAddressNew = createAddress()
		accountOwnerNew = createAccountOwner()
		;({ proxy: accountNew } =
			await createAccount(
				ethersSigners,
				await ethersSigners.getAddress(),
				entryPoint.address
		))
		await fund(account)		
		await accountNew.addDeposit({value: ethers.utils.parseEther("1")})		
		await accountNew.withdrawDepositTo(beneficiaryAddressNew, ethers.utils.parseEther("0.1"))
		expect(ethers.utils.formatEther(await ethers.provider.getBalance(beneficiaryAddressNew))).to.equal('0.1')
	})	

	it('verify paymaster bundling entrypoint', async () => {
		console.log(
			'bundling paymaster %s to entryPoint:%s',
			paymaster.address,
			await paymaster.entryPoint()
		)
		expect(await paymaster.entryPoint()).to.equal(entryPoint.address)
	})

	it('paymaster deposit should equal entryPoint balance', async () => {
		expect(await entryPoint.balanceOf(paymaster.address)).to.equal(ethers.utils.parseEther("1"))
	})

	it('paymaster get depost info should succeed',async () => {
		expect(await paymaster.getDeposit()).to.equal(ethers.utils.parseEther('1'))
	})

	it('paymaster stake should fail with wrong Delay sec', async () => {
		await expect(paymaster.addStake(0, 
			{value: ethers.utils.parseEther("1")}))
			.to.revertedWith('must specify unstake delay')
	})
	it('paymaster stake should fail with 0 ETH value',async () => {
		await expect(paymaster.addStake(2,
			{value: ethers.utils.parseEther('0')}))
			.to.revertedWith('no stake specified')
	})
	it('paymaster unlockStake should fail before stake ETH',async () => {
		await expect(paymaster.unlockStake()).to.revertedWith('not staked')
	})

	it('paymaster stake should fail with lower stake time',async () => {
		await paymaster.addStake(2, {value: ethers.utils.parseEther('1')})
		await expect(paymaster.addStake(1,
			{value: ethers.utils.parseEther('1')}))
			.to.revertedWith('cannot decrease unstake time')
	})
	it('paymaster unlockStake should fail before unstake time',async () => {
		await paymaster.addStake(3, {value: ethers.utils.parseEther('1')})
		await expect(paymaster.withdrawStake(beneficiaryAddress)).to.revertedWith('must call unlockStake() first')
	})
	it('paymaster unlockStake should fail before unstake time',async () => {
		await paymaster.addStake(4, {value: ethers.utils.parseEther('1')})
		await paymaster.unlockStake();
		await expect(paymaster.withdrawStake(beneficiaryAddress)).to.revertedWith('Stake withdrawal is not due')
	})	
	it('paymaster unlockStake should fail if you call it twice',async () => {
		await paymaster.addStake(5, {value: ethers.utils.parseEther('1')})
		await paymaster.unlockStake();
		await expect(paymaster.unlockStake()).to.revertedWith('already unstaking')
	})	

	it('paymaster withdrawto should succeed',async () => {
		await paymaster.addStake(7, {value: ethers.utils.parseEther('1')})
		await ethers.provider.send('evm_increaseTime', [10])
		expect(paymaster.withdrawTo(beneficiaryAddress, ethers.utils.parseEther('0.01'))).to.satisfy
	})


	it('[Gas Trace] - 1st handle batch of ERC20 transfer Ops with paymaster', async () => {
		const ops: UserOperationStruct[] = []
		let accountFactory: AccountFactory

		for (let testLoop = 0; testLoop < testLoopLimit; testLoop++) {
			const { op, accountOwner, accountFactory } =
				await generateBatchofERC20TransferOp(
					ethersSigners,
					token,
					entryPoint,
					account,
					testLoop,
					paymaster,
					ethersSigners,
					undefined,
					undefined,
					notFund
				)
			ops.push(op)
			accountOwners.push(accountOwner)
			accountFactorys.push(accountFactory)
		}

		console.log(
			'  estimateGas =',
			await entryPoint.estimateGas
			.handleOps(ops,        
				ProofData.proof,
				[BigNumber.from(ProofData.pub_ins[0])], 
				beneficiaryAddress,
				{
					maxFeePerGas: 1e9,
					gasLimit: 30000000,
				})
				.then(tostr)
		)

		const tx = await entryPoint.handleOps(ops,        
			ProofData.proof,
			[BigNumber.from(ProofData.pub_ins[0])], 
			beneficiaryAddress,
			{
				maxFeePerGas: 1e9,
				gasLimit: 30000000,
			})
			.then(async (t) => await t.wait())

		console.log(
			'batch transfer gasused:',
			tx.gasUsed.toString(),
			'avgGas:',
			tx.gasUsed.div(testLoopLimit).toString(),
			'tx:',
			testLoopLimit
		)

		gasFirst = tx.gasUsed.toNumber()

		for (let testloop = 0; testloop < testLoopLimit; testloop++) {
			const balance = await token.balanceOf(accountOwners[testloop].address)
			expect(balance).to.equal((testloop + 1) * 100)
		}
	})

	it('[Gas Trace] - 2th handle batch of ERC20 transfer Ops with paymaster', async () => {
		const ops: UserOperationStruct[] = []

		for (let testLoop = 0; testLoop < testLoopLimit; testLoop++) {
			const { op, accountOwner } = await generateBatchofERC20TransferOp(
				ethersSigners,
				token,
				entryPoint,
				account,
				testLoop,
				paymaster,
				ethersSigners,
				accountOwners[testLoop],
				accountFactorys[testLoop],
				notFund
			)
			ops.push(op)
		}

		console.log(
			'  estimateGas=',
			await entryPoint.estimateGas
			.handleOps(ops,        
				ProofData.proof,
				[BigNumber.from(ProofData.pub_ins[0])], 
				beneficiaryAddress, { maxFeePerGas: 1e9 })
				.then(tostr)
		)

		const tx = await entryPoint.handleOps(ops,        
			ProofData.proof,
			[BigNumber.from(ProofData.pub_ins[0])], 
			beneficiaryAddress,
			{
				maxFeePerGas: 1e9,
				gasLimit: 30000000,
			})
			.then(async (t) => await t.wait())

		console.log(
			'batch transfer gasused:',
			tx.gasUsed.toString(),
			'avgGas:',
			tx.gasUsed.div(testLoopLimit).toString(),
			'tx:',
			testLoopLimit
		)

		gasSecond = tx.gasUsed.toNumber()
	})

	it('compare gas difference', async () => {
		if (gasFirst != undefined && gasSecond != undefined) {
			console.log('gasFirst:', gasFirst, 'gasSecond:', gasSecond)
			console.log(
				'gasdiff:',
				gasFirst - gasSecond,
				'gasdiff%:',
				(gasFirst - gasSecond) / gasFirst
			)
			//expect(gasFirst).to.be.greaterThan(gasSecond)
		}
	})

})